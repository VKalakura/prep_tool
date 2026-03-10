const nameInput = document.querySelectorAll('.name-valid');



function inputValidName(num){
    nameInput[num].addEventListener('input', ()=>{
        validName(num)
    })
}

function validName(num) {

        if (nameInput[num].value.length < 1) {
            nameInput[num].classList.add('activeBad');
            event.preventDefault();
        } else {
            nameInput[num].classList.remove('activeBad');
            nameInput[num].classList.add('activeGood');
        }

}

